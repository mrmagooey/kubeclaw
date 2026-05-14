import express from 'express';
import crypto from 'crypto';

const DIMS = 1536;

/**
 * Generate a deterministic unit-normalised embedding for a string.
 * Algorithm: repeatedly SHA-256 hash "<input>:<counter>" to produce seed
 * bytes, interpret each byte as a float in [-1, 1], fill 1536 dims, then
 * L2-normalise the result so cosine distance behaves correctly in Qdrant.
 */
export function embed(text) {
  const floats = new Float64Array(DIMS);
  let filled = 0;
  let counter = 0;

  while (filled < DIMS) {
    const hash = crypto
      .createHash('sha256')
      .update(`${text}:${counter}`)
      .digest();
    counter++;

    for (let i = 0; i < hash.length && filled < DIMS; i++) {
      // Map byte [0,255] → float [-1, 1]
      floats[filled++] = (hash[i] / 127.5) - 1.0;
    }
  }

  // L2-normalise
  let norm = 0;
  for (let i = 0; i < DIMS; i++) norm += floats[i] * floats[i];
  norm = Math.sqrt(norm);
  const result = new Array(DIMS);
  for (let i = 0; i < DIMS; i++) result[i] = floats[i] / norm;
  return result;
}

function startServer() {
  const app = express();
  app.use(express.json());

  app.post('/v1/embeddings', (req, res) => {
    const { model = 'test-embedding', input } = req.body;
    const inputs = Array.isArray(input) ? input : [input];

    console.log(
      `embed: count=${inputs.length} input[0]="${String(inputs[0]).slice(0, 40)}"`
    );

    const data = inputs.map((text, index) => ({
      object: 'embedding',
      embedding: embed(String(text)),
      index,
    }));

    const totalTokens = inputs.reduce(
      (sum, t) => sum + Math.ceil(String(t).length / 4),
      0
    );

    res.json({
      object: 'list',
      data,
      model,
      usage: {
        prompt_tokens: totalTokens,
        total_tokens: totalTokens,
      },
    });
  });

  app.get('/health', (_req, res) => {
    res.json({ ok: true });
  });

  const port = parseInt(process.env.PORT ?? '8080', 10);
  app.listen(port, () => {
    console.log(`test-embedding-server listening on port ${port}`);
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startServer();

  // Determinism + orthogonality verification
  const alice1 = embed('alice');
  const alice2 = embed('alice');
  const bob = embed('bob');

  const maxDiff = alice1.reduce((m, v, i) => Math.max(m, Math.abs(v - alice2[i])), 0);
  console.assert(maxDiff === 0, `FAIL determinism: maxDiff=${maxDiff}`);
  console.log(`determinism check: maxDiff=${maxDiff} (expected 0) ✓`);

  let dot = 0;
  for (let i = 0; i < DIMS; i++) dot += alice1[i] * bob[i];
  // Both are unit vectors so dot == cosine similarity
  console.assert(Math.abs(dot) < 0.5, `FAIL orthogonality: cosine(alice,bob)=${dot}`);
  console.log(`orthogonality check: cosine(alice,bob)=${dot.toFixed(6)} (expected |x|<0.5) ✓`);
}
