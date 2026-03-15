#!/usr/bin/env node
/**
 * E2E Test Reporter
 *
 * Parses test results and generates:
 * - JUnit XML for CI integration
 * - Markdown summary report
 * - Exit codes based on results
 */

import {
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  statSync,
} from 'fs';
import { join, basename, extname } from 'path';

const args = process.argv.slice(2);
const options = {
  input: null,
  output: null,
  summary: null,
  combine: false,
};

// Parse arguments
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--input' || arg === '-i') {
    options.input = args[++i];
  } else if (arg === '--output' || arg === '-o') {
    options.output = args[++i];
  } else if (arg === '--summary' || arg === '-s') {
    options.summary = args[++i];
  } else if (arg === '--combine' || arg === '-c') {
    options.combine = true;
  }
}

/**
 * Escape XML special characters
 */
function escapeXml(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Generate JUnit XML from test results
 */
function generateJUnit(results, suiteName = 'E2E Tests') {
  const timestamp = new Date().toISOString();
  const testCases = [];
  let totalTests = 0;
  let failures = 0;
  let errors = 0;
  let duration = 0;

  if (Array.isArray(results)) {
    // Handle vitest JSON format
    for (const result of results) {
      totalTests += result.assertionResults?.length || 0;
      duration += result.endTime - result.startTime || 0;

      for (const test of result.assertionResults || []) {
        const testCase = {
          name: test.title || test.fullName || 'Unknown',
          classname: result.name || suiteName,
          time: ((test.duration || 0) / 1000).toFixed(3),
          status: test.status || 'unknown',
        };

        if (test.status === 'failed') {
          failures++;
          testCase.failure = {
            message: escapeXml(
              test.failureMessages?.join('\n') || 'Test failed',
            ),
            type: 'AssertionError',
          };
        }

        testCases.push(testCase);
      }
    }
  } else if (results.testResults) {
    // Handle aggregated results
    for (const suite of results.testResults) {
      totalTests += suite.numPassingTests + suite.numFailingTests;
      failures += suite.numFailingTests;
      duration += suite.perfStats?.runtime || 0;

      for (const test of suite.testResults || []) {
        const testCase = {
          name: test.title || 'Unknown',
          classname: suite.testFilePath || suiteName,
          time: ((test.duration || 0) / 1000).toFixed(3),
          status: test.status,
        };

        if (test.status === 'failed') {
          testCase.failure = {
            message: escapeXml(
              test.failureMessages?.join('\n') || 'Test failed',
            ),
            type: 'AssertionError',
          };
        }

        testCases.push(testCase);
      }
    }
  }

  // Generate JUnit XML
  let xml = `<?xml version="1.0" encoding="UTF-8"?>\n`;
  xml += `<testsuites name="${escapeXml(suiteName)}" tests="${totalTests}" failures="${failures}" errors="${errors}" time="${(duration / 1000).toFixed(3)}" timestamp="${timestamp}">\n`;
  xml += `  <testsuite name="${escapeXml(suiteName)}" tests="${totalTests}" failures="${failures}" errors="${errors}" time="${(duration / 1000).toFixed(3)}">\n`;

  for (const testCase of testCases) {
    xml += `    <testcase name="${escapeXml(testCase.name)}" classname="${escapeXml(testCase.classname)}" time="${testCase.time}">\n`;

    if (testCase.failure) {
      xml += `      <failure message="${escapeXml(testCase.failure.message)}" type="${testCase.failure.type}"></failure>\n`;
    }

    xml += `    </testcase>\n`;
  }

  xml += `  </testsuite>\n`;
  xml += `</testsuites>\n`;

  return { xml, stats: { total: totalTests, failures, errors, duration } };
}

/**
 * Generate Markdown summary report
 */
function generateMarkdown(results, title = 'E2E Test Results') {
  let total = 0;
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  let duration = 0;
  const details = [];

  if (Array.isArray(results)) {
    for (const result of results) {
      const suiteName = result.name || 'Test Suite';
      const suiteTests = result.assertionResults?.length || 0;
      const suitePassed =
        result.assertionResults?.filter((t) => t.status === 'passed').length ||
        0;
      const suiteFailed =
        result.assertionResults?.filter((t) => t.status === 'failed').length ||
        0;
      const suiteSkipped =
        result.assertionResults?.filter(
          (t) => t.status === 'skipped' || t.status === 'pending',
        ).length || 0;

      total += suiteTests;
      passed += suitePassed;
      failed += suiteFailed;
      skipped += suiteSkipped;
      duration += result.endTime - result.startTime || 0;

      details.push({
        name: suiteName,
        total: suiteTests,
        passed: suitePassed,
        failed: suiteFailed,
        skipped: suiteSkipped,
        tests: result.assertionResults || [],
      });
    }
  } else if (results.testResults) {
    for (const suite of results.testResults) {
      total += suite.numPassingTests + suite.numFailingTests;
      passed += suite.numPassingTests;
      failed += suite.numFailingTests;
      skipped += suite.numPendingTests || 0;
      duration += suite.perfStats?.runtime || 0;

      details.push({
        name: suite.testFilePath || 'Test Suite',
        total: suite.numPassingTests + suite.numFailingTests,
        passed: suite.numPassingTests,
        failed: suite.numFailingTests,
        skipped: suite.numPendingTests || 0,
        tests: suite.testResults || [],
      });
    }
  }

  let md = `# ${title}\n\n`;
  md += `## Summary\n\n`;
  md += `- **Total Tests:** ${total}\n`;
  md += `- **Passed:** ${passed} ✅\n`;
  md += `- **Failed:** ${failed} ❌\n`;
  md += `- **Skipped:** ${skipped} ⏭️\n`;
  md += `- **Duration:** ${(duration / 1000).toFixed(2)}s\n`;
  md += `- **Success Rate:** ${total > 0 ? ((passed / total) * 100).toFixed(1) : 0}%\n\n`;

  // Status badge
  const status = failed > 0 ? '❌ FAILED' : '✅ PASSED';
  md += `## Status: ${status}\n\n`;

  // Test details
  if (details.length > 0) {
    md += `## Test Suites\n\n`;
    for (const detail of details) {
      const suiteStatus = detail.failed > 0 ? '❌' : '✅';
      md += `### ${suiteStatus} ${detail.name}\n\n`;
      md += `- Total: ${detail.total}\n`;
      md += `- Passed: ${detail.passed}\n`;
      md += `- Failed: ${detail.failed}\n`;
      md += `- Skipped: ${detail.skipped}\n\n`;

      // Failed tests
      const failedTests = detail.tests.filter((t) => t.status === 'failed');
      if (failedTests.length > 0) {
        md += `#### Failed Tests\n\n`;
        for (const test of failedTests) {
          md += `- ❌ **${test.title || test.fullName}**\n`;
          if (test.failureMessages) {
            md += `  \`\`\`\n`;
            md += `  ${test.failureMessages.join('\n  ')}\n`;
            md += `  \`\`\`\n`;
          }
        }
        md += '\n';
      }
    }
  }

  return md;
}

/**
 * Find and load all result files from a directory
 */
function loadResultsFromDir(dir) {
  const results = [];
  const files = readdirSync(dir);

  for (const file of files) {
    const fullPath = join(dir, file);
    const stat = statSync(fullPath);

    if (stat.isDirectory()) {
      results.push(...loadResultsFromDir(fullPath));
    } else if (extname(file) === '.json') {
      try {
        const content = readFileSync(fullPath, 'utf8');
        const data = JSON.parse(content);
        results.push({ ...data, _source: file });
      } catch (err) {
        console.warn(`Warning: Could not parse ${file}: ${err.message}`);
      }
    }
  }

  return results;
}

/**
 * Main execution
 */
function main() {
  try {
    let results = [];

    if (options.combine) {
      // Combine multiple result files
      if (!options.input || !existsSync(options.input)) {
        console.error('Error: --combine requires a valid input directory');
        process.exit(1);
      }
      results = loadResultsFromDir(options.input);
    } else {
      // Single result file
      if (!options.input || !existsSync(options.input)) {
        console.error('Error: Input file not found');
        process.exit(1);
      }
      const content = readFileSync(options.input, 'utf8');
      results = [JSON.parse(content)];
    }

    // Generate JUnit XML
    if (options.output) {
      const { xml, stats } = generateJUnit(
        results,
        options.combine ? 'Combined E2E Tests' : 'E2E Tests',
      );
      writeFileSync(options.output, xml);
      console.log(`JUnit XML written to: ${options.output}`);
      console.log(
        `Tests: ${stats.total}, Failures: ${stats.failures}, Errors: ${stats.errors}`,
      );
    }

    // Generate Markdown summary
    if (options.summary) {
      const md = generateMarkdown(
        results,
        options.combine ? 'Combined E2E Test Results' : 'E2E Test Results',
      );
      writeFileSync(options.summary, md);
      console.log(`Markdown summary written to: ${options.summary}`);
    }

    // Determine exit code
    let hasFailures = false;
    for (const result of results) {
      if (result.numFailingTests > 0 || result.numFailedTests > 0) {
        hasFailures = true;
        break;
      }
      if (result.assertionResults) {
        const failed = result.assertionResults.filter(
          (t) => t.status === 'failed',
        ).length;
        if (failed > 0) {
          hasFailures = true;
          break;
        }
      }
    }

    if (hasFailures) {
      console.log('\nTests completed with failures');
      // Mark failure for CI
      if (options.output) {
        writeFileSync(options.output.replace('.xml', '') + '-failed', '');
      }
      process.exit(1);
    } else {
      console.log('\nAll tests passed!');
      process.exit(0);
    }
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(2);
  }
}

main();
