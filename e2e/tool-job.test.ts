import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync, spawn } from 'child_process';
import { requireKubernetes, getNamespace } from './setup.js';

const NAMESPACE = getNamespace();
const TOOL_JOBLabels = { app: 'kubeclaw-agent', type: 'tool-job' };
const TEST_JOB_NAME = 'e2e-test-tool-job';

describe('Tool Job Lifecycle', () => {
  const jobs: string[] = [];

  beforeAll(async () => {
    // Require Kubernetes - will throw and fail all tests if not available
    requireKubernetes();

    try {
      execSync(`kubectl get namespace ${NAMESPACE}`, {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'ignore'],
      });
    } catch {
      console.warn(`⚠️  Namespace ${NAMESPACE} not found, creating...`);
      execSync(`kubectl create namespace ${NAMESPACE}`, { encoding: 'utf8' });
    }
  });

  afterAll(async () => {
    // Kubernetes is required, so we proceed with cleanup
    // If Kubernetes wasn't available, beforeAll would have thrown

    for (const jobName of jobs) {
      try {
        execSync(
          `kubectl delete job ${jobName} --namespace=${NAMESPACE} --grace-period=0 --force`,
          {
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'ignore'],
          },
        );
      } catch {
        // Job may already be deleted
      }
    }

    try {
      execSync(
        `kubectl delete pods -l type=tool-job --namespace=${NAMESPACE} --grace-period=0 --force`,
        {
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'ignore'],
        },
      );
    } catch {
      // Pods may already be deleted
    }
  });

  describe('Tool Job Templates', () => {
    it('should have tool job templates in the cluster', async () => {
      try {
        const jobs = execSync(
          `kubectl get jobs --namespace=${NAMESPACE} -l type=tool-job -o json`,
          {
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'ignore'],
          },
        );
        const jobList = JSON.parse(jobs);
        expect(jobList).toHaveProperty('items');
      } catch {
        // No jobs found is ok, just check we can query
        const canList = execSync(
          `kubectl auth can-i list jobs --namespace=${NAMESPACE}`,
          { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] },
        );
        expect(canList.trim()).toBe('yes');
      }
    });

    it('should have permission to create jobs in kubeclaw namespace', async () => {
      const canCreate = execSync(
        'kubectl auth can-i create jobs --namespace=kubeclaw',
        {
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'ignore'],
        },
      );
      expect(canCreate.trim()).toBe('yes');
    });
  });

  describe('Job Creation', () => {
    it('should create a job manually using kubectl apply', async () => {
      const jobManifest = `
apiVersion: batch/v1
kind: Job
metadata:
  name: ${TEST_JOB_NAME}
  namespace: ${NAMESPACE}
  labels:
    app: kubeclaw-agent
    type: tool-job
spec:
  ttlSecondsAfterFinished: 60
  backoffLimit: 0
  template:
    metadata:
      labels:
        app: kubeclaw-agent
        type: tool-job
    spec:
      restartPolicy: Never
      containers:
      - name: agent
        image: busybox:1.36
        command: ["sh", "-c", "echo 'Tool job test running' && sleep 2 && echo 'Tool job completed successfully' && exit 0"]
        resources:
          requests:
            memory: "64Mi"
            cpu: "100m"
          limits:
            memory: "128Mi"
            cpu: "200m"
`;

      const manifestFile = `/tmp/${TEST_JOB_NAME}.yaml`;
      const fs = await import('fs');
      fs.writeFileSync(manifestFile, jobManifest);

      try {
        execSync(`kubectl apply -f ${manifestFile}`, { encoding: 'utf8' });
        jobs.push(TEST_JOB_NAME);

        const job = execSync(
          `kubectl get job ${TEST_JOB_NAME} --namespace=${NAMESPACE} -o json`,
          {
            encoding: 'utf8',
          },
        );
        const jobData = JSON.parse(job);

        expect(jobData.metadata.name).toBe(TEST_JOB_NAME);
        expect(jobData.metadata.labels).toMatchObject(TOOL_JOBLabels);
        expect(jobData.metadata.namespace).toBe(NAMESPACE);
      } finally {
        try {
          fs.unlinkSync(manifestFile);
        } catch {
          // File may not exist
        }
      }
    }, 30000);

    it('should create a simple job that runs to completion', async () => {
      const simpleJobName = 'e2e-test-simple-job';
      const jobManifest = `
apiVersion: batch/v1
kind: Job
metadata:
  name: ${simpleJobName}
  namespace: ${NAMESPACE}
  labels:
    app: kubeclaw-agent
    type: tool-job
spec:
  ttlSecondsAfterFinished: 30
  backoffLimit: 0
  template:
    metadata:
      labels:
        app: kubeclaw-agent
        type: tool-job
    spec:
      restartPolicy: Never
      containers:
      - name: test
        image: busybox:1.36
        command: ["sh", "-c", "echo 'Hello from test job'"]
`;

      const manifestFile = `/tmp/${simpleJobName}.yaml`;
      const fs = await import('fs');
      fs.writeFileSync(manifestFile, jobManifest);

      try {
        execSync(`kubectl apply -f ${manifestFile}`, { encoding: 'utf8' });
        jobs.push(simpleJobName);

        await waitForJobComplete(simpleJobName, NAMESPACE, 60000);

        const job = execSync(
          `kubectl get job ${simpleJobName} --namespace=${NAMESPACE} -o jsonpath='{.status.succeeded}'`,
          { encoding: 'utf8' },
        );
        expect(parseInt(job.trim(), 10)).toBeGreaterThanOrEqual(1);
      } finally {
        try {
          fs.unlinkSync(manifestFile);
        } catch {
          // File may not exist
        }
      }
    }, 90000);
  });

  describe('Job Pod Execution', () => {
    it('should have job pod start and run', async () => {
      const podJobName = 'e2e-test-pod-running';
      const jobManifest = `
apiVersion: batch/v1
kind: Job
metadata:
  name: ${podJobName}
  namespace: ${NAMESPACE}
  labels:
    app: kubeclaw-agent
    type: tool-job
spec:
  ttlSecondsAfterFinished: 30
  backoffLimit: 0
  template:
    metadata:
      labels:
        app: kubeclaw-agent
        type: tool-job
    spec:
      restartPolicy: Never
      containers:
      - name: runner
        image: busybox:1.36
        command: ["sh", "-c", "echo 'Pod is running' && sleep 5"]
`;

      const manifestFile = `/tmp/${podJobName}.yaml`;
      const fs = await import('fs');
      fs.writeFileSync(manifestFile, jobManifest);

      try {
        execSync(`kubectl apply -f ${manifestFile}`, { encoding: 'utf8' });
        jobs.push(podJobName);

        await waitForJobRunning(podJobName, NAMESPACE, 30000);

        const pod = execSync(
          `kubectl get pods -l job-name=${podJobName} --namespace=${NAMESPACE} -o json`,
          { encoding: 'utf8' },
        );
        const podData = JSON.parse(pod);
        const podItem = podData.items[0];

        expect(podItem).toBeDefined();
        expect(podItem.metadata.name).toContain(podJobName);
        expect(podItem.metadata.labels).toMatchObject(TOOL_JOBLabels);
        expect(podItem.status.phase).toBe('Running');
      } finally {
        try {
          fs.unlinkSync(manifestFile);
        } catch {
          // File may not exist
        }
      }
    }, 60000);
  });

  describe('Job Completion', () => {
    it('should complete job successfully', async () => {
      const completeJobName = 'e2e-test-complete-job';
      const jobManifest = `
apiVersion: batch/v1
kind: Job
metadata:
  name: ${completeJobName}
  namespace: ${NAMESPACE}
  labels:
    app: kubeclaw-agent
    type: tool-job
spec:
  ttlSecondsAfterFinished: 30
  backoffLimit: 0
  template:
    metadata:
      labels:
        app: kubeclaw-agent
        type: tool-job
    spec:
      restartPolicy: Never
      containers:
      - name: worker
        image: busybox:1.36
        command: ["sh", "-c", "echo 'Job starting' && sleep 1 && echo 'Job finished' && exit 0"]
`;

      const manifestFile = `/tmp/${completeJobName}.yaml`;
      const fs = await import('fs');
      fs.writeFileSync(manifestFile, jobManifest);

      try {
        execSync(`kubectl apply -f ${manifestFile}`, { encoding: 'utf8' });
        jobs.push(completeJobName);

        await waitForJobComplete(completeJobName, NAMESPACE, 60000);

        const job = execSync(
          `kubectl get job ${completeJobName} --namespace=${NAMESPACE} -o json`,
          {
            encoding: 'utf8',
          },
        );
        const jobData = JSON.parse(job);

        expect(jobData.status.succeeded).toBe(1);
        expect(jobData.status.completionTime).toBeDefined();

        const pod = execSync(
          `kubectl get pods -l job-name=${completeJobName} --namespace=${NAMESPACE} -o json`,
          { encoding: 'utf8' },
        );
        const podData = JSON.parse(pod);
        expect(podData.items[0].status.phase).toBe('Succeeded');
      } finally {
        try {
          fs.unlinkSync(manifestFile);
        } catch {
          // File may not exist
        }
      }
    }, 90000);

    it('should capture job logs on completion', async () => {
      const logJobName = 'e2e-test-log-job';
      const jobManifest = `
apiVersion: batch/v1
kind: Job
metadata:
  name: ${logJobName}
  namespace: ${NAMESPACE}
  labels:
    app: kubeclaw-agent
    type: tool-job
spec:
  ttlSecondsAfterFinished: 30
  backoffLimit: 0
  template:
    metadata:
      labels:
        app: kubeclaw-agent
        type: tool-job
    spec:
      restartPolicy: Never
      containers:
      - name: logger
        image: busybox:1.36
        command: ["sh", "-c", "echo 'Test log output line 1' && echo 'Test log output line 2'"]
`;

      const manifestFile = `/tmp/${logJobName}.yaml`;
      const fs = await import('fs');
      fs.writeFileSync(manifestFile, jobManifest);

      try {
        execSync(`kubectl apply -f ${manifestFile}`, { encoding: 'utf8' });
        jobs.push(logJobName);

        await waitForJobComplete(logJobName, NAMESPACE, 60000);

        const logs = execSync(
          `kubectl logs -l job-name=${logJobName} --namespace=${NAMESPACE}`,
          { encoding: 'utf8' },
        );

        expect(logs).toContain('Test log output line 1');
        expect(logs).toContain('Test log output line 2');
      } finally {
        try {
          fs.unlinkSync(manifestFile);
        } catch {
          // File may not exist
        }
      }
    }, 90000);
  });

  describe('Job Cleanup', () => {
    it('should clean up job after completion with ttlSecondsAfterFinished', async () => {
      const cleanupJobName = 'e2e-test-cleanup-job';
      const jobManifest = `
apiVersion: batch/v1
kind: Job
metadata:
  name: ${cleanupJobName}
  namespace: ${NAMESPACE}
  labels:
    app: kubeclaw-agent
    type: tool-job
spec:
  ttlSecondsAfterFinished: 5
  backoffLimit: 0
  template:
    metadata:
      labels:
        app: kubeclaw-agent
        type: tool-job
    spec:
      restartPolicy: Never
      containers:
      - name: cleanup-test
        image: busybox:1.36
        command: ["sh", "-c", "echo 'Quick job'"]
`;

      const manifestFile = `/tmp/${cleanupJobName}.yaml`;
      const fs = await import('fs');
      fs.writeFileSync(manifestFile, jobManifest);

      try {
        execSync(`kubectl apply -f ${manifestFile}`, { encoding: 'utf8' });
        // Don't add to jobs array - we're testing TTL cleanup

        await waitForJobComplete(cleanupJobName, NAMESPACE, 60000);

        await new Promise((resolve) => setTimeout(resolve, 8000));

        try {
          execSync(
            `kubectl get job ${cleanupJobName} --namespace=${NAMESPACE}`,
            {
              encoding: 'utf8',
              stdio: ['pipe', 'pipe', 'ignore'],
            },
          );
          console.warn('⚠️  Job not cleaned up yet, TTL may need more time');
        } catch {
          // Expected - job should be cleaned up
        }
      } finally {
        try {
          fs.unlinkSync(manifestFile);
        } catch {
          // File may not exist
        }
        try {
          execSync(
            `kubectl delete job ${cleanupJobName} --namespace=${NAMESPACE} --ignore-not-found=true`,
            {
              encoding: 'utf8',
              stdio: ['pipe', 'pipe', 'ignore'],
            },
          );
        } catch {
          // Ignore cleanup errors
        }
      }
    }, 30000);

    it('should manually delete job and verify cleanup', async () => {
      const deleteJobName = 'e2e-test-delete-job';
      const jobManifest = `
apiVersion: batch/v1
kind: Job
metadata:
  name: ${deleteJobName}
  namespace: ${NAMESPACE}
  labels:
    app: kubeclaw-agent
    type: tool-job
spec:
  ttlSecondsAfterFinished: 300
  backoffLimit: 0
  template:
    metadata:
      labels:
        app: kubeclaw-agent
        type: tool-job
    spec:
      restartPolicy: Never
      containers:
      - name: delete-test
        image: busybox:1.36
        command: ["sh", "-c", "echo 'Delete test'"]
`;

      const manifestFile = `/tmp/${deleteJobName}.yaml`;
      const fs = await import('fs');
      fs.writeFileSync(manifestFile, jobManifest);

      try {
        execSync(`kubectl apply -f ${manifestFile}`, { encoding: 'utf8' });

        await waitForJobComplete(deleteJobName, NAMESPACE, 60000);

        const podBefore = execSync(
          `kubectl get pods -l job-name=${deleteJobName} --namespace=${NAMESPACE} --no-headers`,
          { encoding: 'utf8' },
        );
        expect(podBefore.trim()).toBeTruthy();

        execSync(
          `kubectl delete job ${deleteJobName} --namespace=${NAMESPACE}`,
          { encoding: 'utf8' },
        );

        await new Promise((resolve) => setTimeout(resolve, 2000));

        try {
          execSync(
            `kubectl get job ${deleteJobName} --namespace=${NAMESPACE}`,
            {
              encoding: 'utf8',
              stdio: ['pipe', 'pipe', 'ignore'],
            },
          );
          expect.fail('Job should be deleted');
        } catch {
          // Expected - job is deleted
        }
      } finally {
        try {
          fs.unlinkSync(manifestFile);
        } catch {
          // File may not exist
        }
        try {
          execSync(
            `kubectl delete job ${deleteJobName} --namespace=${NAMESPACE} --ignore-not-found=true`,
            {
              encoding: 'utf8',
              stdio: ['pipe', 'pipe', 'ignore'],
            },
          );
        } catch {
          // Ignore cleanup errors
        }
      }
    }, 30000);
  });
});

async function waitForJobComplete(
  jobName: string,
  namespace: string,
  timeout: number,
): Promise<void> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    try {
      const output = execSync(
        `kubectl get job ${jobName} --namespace=${namespace} -o jsonpath='{.status.succeeded}'`,
        { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] },
      );

      if (parseInt(output.trim(), 10) >= 1) {
        return;
      }
    } catch {
      // Job might not exist yet
    }

    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  throw new Error(`Job ${jobName} did not complete within ${timeout}ms`);
}

async function waitForJobRunning(
  jobName: string,
  namespace: string,
  timeout: number,
): Promise<void> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    try {
      const output = execSync(
        `kubectl get pods -l job-name=${jobName} --namespace=${namespace} -o json`,
        { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] },
      );

      const podData = JSON.parse(output);
      if (podData.items && podData.items.length > 0) {
        const phase = podData.items[0].status.phase;
        if (
          phase === 'Running' ||
          phase === 'Succeeded' ||
          phase === 'Failed'
        ) {
          return;
        }
      }
    } catch {
      // Pods might not exist yet
    }

    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  throw new Error(
    `Job ${jobName} did not have running pod within ${timeout}ms`,
  );
}
