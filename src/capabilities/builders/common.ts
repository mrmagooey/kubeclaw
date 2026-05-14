import type { CapabilityResources, CapabilityStorage } from '../types.js';

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
  storage?: CapabilityStorage;
}

export function renderDeploymentAndService(a: CommonRenderArgs): string {
  const memReq = a.resources?.memoryRequest ?? '128Mi';
  const memLim = a.resources?.memoryLimit ?? '256Mi';
  const cpuReq = a.resources?.cpuRequest ?? '50m';
  const cpuLim = a.resources?.cpuLimit ?? '500m';
  const healthPath = a.healthPath ?? '/health';

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
      containers:
        - name: ${a.component}
          image: ${a.image}
          imagePullPolicy: IfNotPresent
${commandBlock}${argsBlock}          ports:
            - containerPort: ${a.port}
              name: http
${envBlock ? `          env:\n${envBlock}\n` : ''}${envFromBlock}          resources:
            requests:
              memory: ${memReq}
              cpu: ${cpuReq}
            limits:
              memory: ${memLim}
              cpu: ${cpuLim}
${volumeMounts}          readinessProbe:
            httpGet:
              path: ${healthPath}
              port: ${a.port}
            initialDelaySeconds: 5
            periodSeconds: 10
          livenessProbe:
            httpGet:
              path: ${healthPath}
              port: ${a.port}
            initialDelaySeconds: 15
            periodSeconds: 30
          securityContext:
            runAsUser: 1000
            runAsGroup: 1000
            runAsNonRoot: true
            allowPrivilegeEscalation: false
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
