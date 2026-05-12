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
- { name: NO_PROXY,           value: "localhost,127.0.0.1,kubeclaw-redis,credential-broker" }
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
all egress destinations that the credential broker handles, suitable for
ServiceEntry generation. Each item has keys: host (string), port (number),
protocol (string). Includes built-in destinations (anthropic, openai, openrouter,
voyage) plus any entries in .Values.credentialInjection.istio.additionalDestinations.
Wrapped in {"items":[...]} so that fromJson produces a traversable map rather
than a bare slice (Helm's fromJson cannot range over a top-level JSON array).
*/}}
{{- define "kubeclaw.egressDestinations" -}}
{{- $built_in := list
      (dict "host" "api.anthropic.com"  "port" 443 "protocol" "HTTPS")
      (dict "host" "api.openai.com"     "port" 443 "protocol" "HTTPS")
      (dict "host" "openrouter.ai"      "port" 443 "protocol" "HTTPS")
      (dict "host" "api.voyageai.com"   "port" 443 "protocol" "HTTPS") -}}
{{- $extra := list -}}
{{- range .Values.credentialInjection.istio.additionalDestinations -}}
  {{- $parts := splitList ":" . -}}
  {{- $h := index $parts 0 -}}
  {{- $p := 443 -}}
  {{- if gt (len $parts) 1 -}}
    {{- $p = index $parts 1 | int -}}
  {{- end -}}
  {{- $extra = append $extra (dict "host" $h "port" $p "protocol" "HTTPS") -}}
{{- end -}}
{{- toJson (dict "items" (concat $built_in $extra)) -}}
{{- end -}}
