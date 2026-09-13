{{- define "crazzychat.name" -}}crazzychat{{- end -}}

{{- define "crazzychat.labels" -}}
app.kubernetes.io/name: {{ include "crazzychat.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end -}}

{{- define "crazzychat.goApiSelector" -}}
app.kubernetes.io/name: {{ include "crazzychat.name" . }}
app.kubernetes.io/component: go-api
{{- end -}}

{{- define "crazzychat.imageRef" -}}
{{- if not .Values.image.tag -}}
{{- fail "image.tag is required — deploy by immutable SHA, never a floating tag" -}}
{{- end -}}
{{ .Values.image.repository }}:{{ .Values.image.tag }}
{{- end -}}
