import { stringify } from 'yaml';
import type {
  CapabilityResources,
  CapabilityStorage,
  ProbeConfig,
  CapabilityScheduling,
  CapabilityPodSecurity,
} from '../types.js';

export function deploymentName(name: string): string {
  return `kubeclaw-cap-${name}`;
}

export interface CommonRenderArgs {
  name: string; // already prefixed
  namespace: string;
  component: string; // value for kubeclaw-component label
  image: string;
  port: number;
  env?: Record<string, string>;
  envFromSecrets?: string[];
  command?: string[];
  args?: string[];
  resources?: CapabilityResources;
  healthPath?: string;
  probe?: ProbeConfig;
  storage?: CapabilityStorage;
  scheduling?: CapabilityScheduling;
  podSecurity?: CapabilityPodSecurity;
}

const TARGET_INDENT = '            '; // 12 spaces (under <probe>: at 10)
const PROBE_INDENT = '          '; // 10 spaces (container-level)

function renderProbeTarget(
  probe: ProbeConfig | undefined,
  healthPath: string | undefined,
  containerPort: number,
): string {
  const port = probe?.port ?? containerPort;
  if ((probe?.type ?? 'http') === 'tcp') {
    return `${TARGET_INDENT}tcpSocket:\n${TARGET_INDENT}  port: ${port}`;
  }
  const path = probe?.path ?? healthPath ?? '/health';
  return `${TARGET_INDENT}httpGet:\n${TARGET_INDENT}  path: ${path}\n${TARGET_INDENT}  port: ${port}`;
}

function renderTiming(
  probe: ProbeConfig | undefined,
  fallback: { initialDelaySeconds: number; periodSeconds: number },
): string {
  const lines = [
    `${TARGET_INDENT}initialDelaySeconds: ${probe?.initialDelaySeconds ?? fallback.initialDelaySeconds}`,
    `${TARGET_INDENT}periodSeconds: ${probe?.periodSeconds ?? fallback.periodSeconds}`,
  ];
  if (probe?.failureThreshold !== undefined)
    lines.push(`${TARGET_INDENT}failureThreshold: ${probe.failureThreshold}`);
  if (probe?.timeoutSeconds !== undefined)
    lines.push(`${TARGET_INDENT}timeoutSeconds: ${probe.timeoutSeconds}`);
  return lines.join('\n');
}

function renderProbes(
  probe: ProbeConfig | undefined,
  healthPath: string | undefined,
  containerPort: number,
): string {
  const target = renderProbeTarget(probe, healthPath, containerPort);
  const readiness =
    `${PROBE_INDENT}readinessProbe:\n${target}\n` +
    renderTiming(probe, { initialDelaySeconds: 5, periodSeconds: 10 });
  const liveness =
    `${PROBE_INDENT}livenessProbe:\n${target}\n` +
    renderTiming(probe, { initialDelaySeconds: 15, periodSeconds: 30 });
  let startup = '';
  if (probe?.startup) {
    const s = probe.startup;
    const t = [
      `${TARGET_INDENT}initialDelaySeconds: ${s.initialDelaySeconds ?? 0}`,
      `${TARGET_INDENT}periodSeconds: ${s.periodSeconds ?? 10}`,
      `${TARGET_INDENT}failureThreshold: ${s.failureThreshold ?? 30}`,
    ].join('\n');
    startup = `\n${PROBE_INDENT}startupProbe:\n${target}\n${t}`;
  }
  return `${readiness}\n${liveness}${startup}`;
}

function renderPodLevel(
  scheduling: CapabilityScheduling | undefined,
  podSecurity: CapabilityPodSecurity | undefined,
): string {
  let out = '';
  if (podSecurity?.fsGroup !== undefined) {
    out += `      securityContext:\n        fsGroup: ${podSecurity.fsGroup}\n`;
  }
  if (scheduling?.runtimeClassName) {
    out += `      runtimeClassName: ${scheduling.runtimeClassName}\n`;
  }
  if (scheduling?.nodeSelector && Object.keys(scheduling.nodeSelector).length) {
    out += '      nodeSelector:\n';
    for (const [k, v] of Object.entries(scheduling.nodeSelector)) {
      out += `        ${JSON.stringify(k)}: ${JSON.stringify(v)}\n`;
    }
  }
  if (scheduling?.tolerations?.length) {
    out += '      tolerations:\n';
    for (const line of stringify(scheduling.tolerations)
      .trimEnd()
      .split('\n')) {
      out += `        ${line}\n`;
    }
  }
  return out;
}

function renderContainerSecurity(
  ps: CapabilityPodSecurity | undefined,
): string {
  return `          securityContext:
            runAsUser: ${ps?.runAsUser ?? 1000}
            runAsGroup: ${ps?.runAsGroup ?? 1000}
            runAsNonRoot: ${ps?.runAsNonRoot ?? true}
            allowPrivilegeEscalation: false`;
}

export function renderDeploymentAndService(a: CommonRenderArgs): string {
  const memReq = a.resources?.memoryRequest ?? '128Mi';
  const memLim = a.resources?.memoryLimit ?? '256Mi';
  const cpuReq = a.resources?.cpuRequest ?? '50m';
  const cpuLim = a.resources?.cpuLimit ?? '500m';
  const gpuLine = a.resources?.gpu
    ? `\n              nvidia.com/gpu: ${a.resources.gpu}`
    : '';
  const envBlock = a.env
    ? Object.entries(a.env)
        .map(
          ([k, v]) =>
            `            - name: ${k}\n              value: ${JSON.stringify(v)}`,
        )
        .join('\n')
    : '';

  const envFromBlock = a.envFromSecrets?.length
    ? `          envFrom:\n` +
      a.envFromSecrets
        .map((s) => `            - secretRef:\n                name: ${s}`)
        .join('\n') +
      '\n'
    : '';

  const commandBlock = a.command
    ? `          command: ${JSON.stringify(a.command)}\n`
    : '';
  const argsBlock = a.args ? `          args: ${JSON.stringify(a.args)}\n` : '';

  const volumeMounts = a.storage
    ? `          volumeMounts:
            - name: data
              mountPath: ${a.storage.mountPath}
`
    : '';
  const volumes = a.storage
    ? `      volumes:
        - name: data
          persistentVolumeClaim:
            claimName: ${a.name}-data
`
    : '';

  const pvc = a.storage
    ? `---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: ${a.name}-data
  namespace: ${a.namespace}
  labels:
    app: ${a.name}
    kubeclaw-component: ${a.component}
spec:
  accessModes: [ReadWriteOnce]
  resources:
    requests:
      storage: ${a.storage.sizeGi}Gi
`
    : '';

  return `apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${a.name}
  namespace: ${a.namespace}
  labels:
    app: ${a.name}
    kubeclaw-component: ${a.component}
spec:
  replicas: 1
  selector:
    matchLabels:
      app: ${a.name}
  template:
    metadata:
      labels:
        app: ${a.name}
        kubeclaw-component: ${a.component}
    spec:
      automountServiceAccountToken: false
${renderPodLevel(a.scheduling, a.podSecurity)}      containers:
        - name: ${a.component}
          image: ${a.image}
          imagePullPolicy: IfNotPresent
${commandBlock}${argsBlock}          ports:
            - containerPort: ${a.port}
              name: http
${envBlock ? `          env:\n${envBlock}\n` : ''}${envFromBlock}          resources:
            requests:
              memory: ${memReq}
              cpu: ${cpuReq}${gpuLine}
            limits:
              memory: ${memLim}
              cpu: ${cpuLim}${gpuLine}
${volumeMounts}${renderProbes(a.probe, a.healthPath, a.port)}
${renderContainerSecurity(a.podSecurity)}
${volumes}---
apiVersion: v1
kind: Service
metadata:
  name: ${a.name}
  namespace: ${a.namespace}
  labels:
    app: ${a.name}
    kubeclaw-component: ${a.component}
spec:
  type: ClusterIP
  selector:
    app: ${a.name}
  ports:
    - port: ${a.port}
      targetPort: http
      protocol: TCP
${pvc}`;
}
