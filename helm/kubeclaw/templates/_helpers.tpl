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
