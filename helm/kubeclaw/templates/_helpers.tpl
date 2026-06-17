{{/*
Resolve the namespace for all kubeclaw resources.

Uses .Values.namespace when explicitly set (legacy override path), otherwise
falls back to .Release.Namespace (the --namespace flag passed to helm install/upgrade).
This ensures that two Helm releases installed into different namespaces never
share resources — fixing the multi-release collision described in Story 165.

Usage: {{ include "kubeclaw.namespace" . }}
*/}}
{{- define "kubeclaw.namespace" -}}
{{- .Values.namespace | default .Release.Namespace -}}
{{- end -}}

{{/*
Full image reference for a named kubeclaw image.
Usage: include "kubeclaw.image" (dict "root" . "name" "kubeclaw-orchestrator")
*/}}
{{- define "kubeclaw.image" -}}
{{- $root := .root -}}
{{- $name := .name -}}
{{- if $root.Values.image.registry -}}
{{ $root.Values.image.registry }}/{{ $name }}:{{ $root.Values.image.tag }}
{{- else -}}
{{ $name }}:{{ $root.Values.image.tag }}
{{- end -}}
{{- end }}

{{/*
imagePullPolicy — defaults to Always when a registry is set, Never otherwise.
Override with image.pullPolicy.
*/}}
{{- define "kubeclaw.pullPolicy" -}}
{{- if .Values.image.pullPolicy -}}
{{ .Values.image.pullPolicy }}
{{- else if .Values.image.registry -}}
Always
{{- else -}}
Never
{{- end -}}
{{- end }}

{{/*
Storage class annotation block — omitted entirely when storageClass is empty
so the cluster default is used.
*/}}
{{- define "kubeclaw.storageClassName" -}}
{{- if .Values.storage.storageClass -}}
storageClassName: {{ .Values.storage.storageClass }}
{{- end -}}
{{- end }}

{{/*
Resolve the kubeclaw-secrets Secret name: existing or the one we create.
*/}}
{{- define "kubeclaw.secretName" -}}
{{- if .Values.secrets.existingSecret -}}
{{ .Values.secrets.existingSecret }}
{{- else -}}
kubeclaw-secrets
{{- end -}}
{{- end }}

{{/*
credentialSidecarContainer renders the Envoy sidecar container.
Caller must have already gated on .Values.credentialInjection.mode == "sidecar".
*/}}
{{- define "kubeclaw.credentialSidecarContainer" -}}
- name: credential-sidecar
  image: {{ .Values.credentialInjection.sidecar.image }}
  imagePullPolicy: IfNotPresent
  args: ["-c", "/etc/envoy/envoy.yaml"]
  ports:
    - name: proxy
      containerPort: {{ .Values.credentialInjection.sidecar.listenPort }}
  volumeMounts:
    - { name: envoy-config, mountPath: /etc/envoy, readOnly: true }
    - { name: broker-token, mountPath: /var/run/secrets/tokens, readOnly: true }
    - { name: egress-ca, mountPath: /etc/ssl/certs, readOnly: true }
  resources: {{ toYaml .Values.credentialInjection.sidecar.resources | nindent 4 }}
  securityContext:
    runAsNonRoot: true
    runAsUser: 1337
    allowPrivilegeEscalation: false
    readOnlyRootFilesystem: true
    capabilities: { drop: [ALL] }
{{- end -}}

{{- define "kubeclaw.credentialSidecarVolumes" -}}
- name: envoy-config
  configMap:
    name: kubeclaw-envoy-sidecar
- name: broker-token
  projected:
    sources:
      - serviceAccountToken:
          audience: kubeclaw-credential-broker
          expirationSeconds: 600
          path: broker-token
- name: egress-ca
  secret:
    secretName: kubeclaw-egress-ca-tls
    items: [{ key: ca.crt, path: kubeclaw-egress-ca.crt }]
{{- end -}}

{{- define "kubeclaw.credentialSidecarEnv" -}}
- { name: HTTPS_PROXY,        value: "http://127.0.0.1:{{ .Values.credentialInjection.sidecar.listenPort }}" }
- { name: HTTP_PROXY,         value: "http://127.0.0.1:{{ .Values.credentialInjection.sidecar.listenPort }}" }
{{/* keep in sync with src/credential-injection/workload-env.ts workloadEnvForSidecar */}}
- { name: NO_PROXY,           value: "localhost,127.0.0.1,kubeclaw-redis,kubeclaw-credential-broker,ollama,.svc,.svc.cluster.local,.cluster.local" }
- { name: NODE_EXTRA_CA_CERTS, value: "/etc/ssl/certs/kubeclaw-egress-ca.crt" }
- { name: SSL_CERT_FILE,       value: "/etc/ssl/certs/kubeclaw-egress-ca.crt" }
{{- end -}}

{{/*
istioInstalled — returns "true" when the networking.istio.io/v1 CRD group is
present in the cluster. Returns "" when running offline (helm template) because
lookup returns an empty map without cluster access.
Usage: {{- if include "kubeclaw.istioInstalled" . }}
*/}}
{{- define "kubeclaw.istioInstalled" -}}
{{- $crd := lookup "apiextensions.k8s.io/v1" "CustomResourceDefinition" "" "virtualservices.networking.istio.io" -}}
{{- if $crd.metadata -}}
true
{{- end -}}
{{- end -}}

{{/*
kubeclaw.requireIstio — fails with a clear message when mode=istio and the
cluster is reachable but Istio CRDs are absent. Silent when running offline.
*/}}
{{- define "kubeclaw.requireIstio" -}}
{{- if eq .Values.credentialInjection.mode "istio" -}}
  {{- $crd := lookup "apiextensions.k8s.io/v1" "CustomResourceDefinition" "" "virtualservices.networking.istio.io" -}}
  {{- if and (not $crd.metadata) (lookup "v1" "Namespace" "" "kube-system").metadata -}}
    {{- fail "credentialInjection.mode=istio requires Istio CRDs. Install Istio >= 1.24 first, or use mode=sidecar." -}}
  {{- end -}}
{{- end -}}
{{- end -}}

{{/*
kubeclaw.egressDestinations — returns a JSON object {"items":[...]} containing
all egress destinations the credential broker handles. Each item has keys:
  host             string  — destination hostname
  port             number  — workload-facing port (always 80, HTTP)
  upstreamPort     number  — port the gateway originates TLS to (443 default)
  upstreamProtocol string  — "HTTPS" (built-ins, additionalDestinations) or
                             "HTTP" (test fixture mock upstream only)
  endpointAddress  string  — optional STATIC/DNS endpoint override (test fixture)

Built-ins are anthropic/openai/openrouter/voyage. additionalDestinations
contributes entries with configurable upstreamPort (default 443).
When credentialInjection.istio.testFixture.enabled=true, one extra entry is
appended for the in-cluster mock-upstream.

Wrapped in {"items":[...]} so fromJson produces a traversable map rather
than a bare slice (Helm's fromJson cannot range over a top-level JSON array).
*/}}
{{- define "kubeclaw.egressDestinations" -}}
{{- $built_in := list
      (dict "host" "api.anthropic.com" "port" 80 "upstreamPort" 443 "upstreamProtocol" "HTTPS")
      (dict "host" "api.openai.com"    "port" 80 "upstreamPort" 443 "upstreamProtocol" "HTTPS")
      (dict "host" "openrouter.ai"     "port" 80 "upstreamPort" 443 "upstreamProtocol" "HTTPS")
      (dict "host" "api.voyageai.com"  "port" 80 "upstreamPort" 443 "upstreamProtocol" "HTTPS") -}}
{{- $extra := list -}}
{{- range .Values.credentialInjection.istio.additionalDestinations -}}
  {{- $parts := splitList ":" . -}}
  {{- $h := index $parts 0 -}}
  {{- $up := 443 -}}
  {{- if gt (len $parts) 1 -}}
    {{- $up = index $parts 1 | int -}}
  {{- end -}}
  {{- $extra = append $extra (dict "host" $h "port" 80 "upstreamPort" $up "upstreamProtocol" "HTTPS") -}}
{{- end -}}
{{- $test := list -}}
{{- if ((.Values.credentialInjection.istio.testFixture).enabled) -}}
  {{- $test = list (dict
        "host" "mock-upstream.kubeclaw-test"
        "port" 80
        "upstreamPort" 80
        "upstreamProtocol" "HTTP"
        "endpointAddress" (printf "kubeclaw-mock-upstream.%s.svc.cluster.local" (include "kubeclaw.namespace" .))) -}}
{{- end -}}
{{- toJson (dict "items" (concat $built_in $extra $test)) -}}
{{- end -}}

{{/*
kubeclaw.llmBrokerEnv — LLM provider envs when credential injection is active
(sidecar or istio, not auditOnly). Channel pods are multi-group → operator-fallback
sentinel KC_PH_FALLBACK_<id> (MUST match FALLBACK_SENTINEL_PREFIX in
src/k8s/job-runner.ts) + http:// base URLs (TLS origination). Base URLs MUST match
the credentialInjection.catalog baseUrlEnvs in values.yaml.
*/}}
{{- define "kubeclaw.llmBrokerEnv" -}}
- { name: OPENAI_API_KEY,      value: "KC_PH_FALLBACK_openai" }
- { name: OPENAI_BASE_URL,     value: "http://api.openai.com/v1" }
- { name: ANTHROPIC_API_KEY,   value: "KC_PH_FALLBACK_anthropic" }
- { name: ANTHROPIC_BASE_URL,  value: "http://api.anthropic.com" }
- { name: OPENROUTER_API_KEY,  value: "KC_PH_FALLBACK_openrouter" }
- { name: OPENROUTER_BASE_URL, value: "http://openrouter.ai/api/v1" }
- { name: VOYAGE_API_KEY,      value: "KC_PH_FALLBACK_voyage" }
- { name: VOYAGE_BASE_URL,     value: "http://api.voyageai.com" }
{{- end -}}

{{/*
kubeclaw.istioBaseUrlEnv — emits env entries for three of the four built-in
broker providers (openai, anthropic, openrouter) pointing at http:// hostnames,
so workload SDKs route through the istio egress gateway for credential stamping.

Voyage is intentionally omitted: its SDK doesn't standardise on a VOYAGE_BASE_URL
env, so an injected default could either be ignored (most Python SDKs use
`VOYAGEAI_API_URL`) or actively conflict with operator config. Operators using
voyage should set the appropriate base-URL env on their workload pod themselves.

Render only when credentialInjection.mode == "istio" and
credentialInjection.auditOnly == false.
*/}}
{{- define "kubeclaw.istioBaseUrlEnv" -}}
- { name: OPENAI_BASE_URL,     value: "http://api.openai.com" }
- { name: ANTHROPIC_BASE_URL,  value: "http://api.anthropic.com" }
- { name: OPENROUTER_BASE_URL, value: "http://openrouter.ai" }
{{- end -}}

{{/*
kubeclaw.bootstrap.runtimePvcAccessModes — renders the accessModes list for the
per-channel runtime PVC. Defaults to [ReadWriteOnce] when not set.
Usage: {{ include "kubeclaw.bootstrap.runtimePvcAccessModes" . }}
*/}}
{{- define "kubeclaw.bootstrap.runtimePvcAccessModes" -}}
{{- $modes := .Values.bootstrap.runtimePvc.accessModes | default (list "ReadWriteOnce") -}}
{{- range $modes }}
- {{ . }}
{{- end }}
{{- end -}}

{{/*
kubeclaw.bootstrap.isRwx — returns "true" if accessModes includes ReadWriteMany.
*/}}
{{- define "kubeclaw.bootstrap.isRwx" -}}
{{- $modes := .Values.bootstrap.runtimePvc.accessModes | default (list "ReadWriteOnce") -}}
{{- range $modes -}}
{{- if eq . "ReadWriteMany" -}}
true
{{- end -}}
{{- end -}}
{{- end -}}
