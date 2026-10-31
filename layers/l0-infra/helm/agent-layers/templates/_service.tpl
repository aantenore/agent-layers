{{/*
Renders one service: Deployment, Service, and optionally PVC and Ingress.
Call with (dict "root" $ "layer" $layerId "name" $name "svc" $svc).
*/}}
{{- define "agent-layers.service" -}}
{{- $root := .root -}}
{{- $svc := .svc -}}
{{- $name := .name -}}
{{- $tag := required (printf "layers.%s.services.%s.image.tag is required" .layer $name) $svc.image.tag | toString -}}
{{- if eq $tag "latest" }}{{ fail (printf "service %s: pin an exact image tag, not latest" $name) }}{{ end -}}
{{- $labels := dict "app.kubernetes.io/name" $name "app.kubernetes.io/part-of" "agent-layers" "agent-layers/layer" .layer "app.kubernetes.io/instance" $root.Release.Name -}}
{{- $selector := dict "app.kubernetes.io/name" $name "app.kubernetes.io/instance" $root.Release.Name -}}
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ $name }}
  labels: {{ $labels | toYaml | nindent 4 }}
spec:
  replicas: {{ if $svc.persistence }}1{{ else }}{{ $svc.replicas | default 1 }}{{ end }}
  {{- if $svc.persistence }}
  strategy:
    type: Recreate
  {{- end }}
  selector:
    matchLabels: {{ $selector | toYaml | nindent 6 }}
  template:
    metadata:
      labels: {{ $labels | toYaml | nindent 8 }}
    spec:
      containers:
        - name: {{ $name }}
          image: "{{ $svc.image.repository }}:{{ $tag }}"
          imagePullPolicy: {{ $root.Values.global.imagePullPolicy }}
          {{- with $svc.args }}
          args: {{ toYaml . | nindent 12 }}
          {{- end }}
          ports:
            - name: http
              containerPort: {{ $svc.port }}
          {{- if or $svc.env $svc.secretRefs }}
          env:
            {{- range $k, $v := $svc.env }}
            - name: {{ $k }}
              value: {{ $v | quote }}
            {{- end }}
            {{- range $svc.secretRefs }}
            - name: {{ . }}
              valueFrom:
                secretKeyRef:
                  name: {{ $root.Values.global.secretName }}
                  key: {{ . }}
            {{- end }}
          {{- end }}
          {{- $probe := ternary (dict "httpGet" (dict "path" ($svc.health | default "/") "port" "http")) (dict "tcpSocket" (dict "port" "http")) (not (empty $svc.health)) }}
          startupProbe:
            {{- toYaml $probe | nindent 12 }}
            periodSeconds: 10
            failureThreshold: 90
          readinessProbe: {{ $probe | toYaml | nindent 12 }}
          livenessProbe: {{ $probe | toYaml | nindent 12 }}
          {{- with $svc.resources }}
          resources: {{ toYaml . | nindent 12 }}
          {{- end }}
          {{- if $svc.persistence }}
          volumeMounts:
            - name: data
              mountPath: {{ $svc.persistence.mountPath }}
          {{- end }}
      {{- if $svc.persistence }}
      volumes:
        - name: data
          persistentVolumeClaim:
            claimName: {{ $name }}-data
      {{- end }}
{{- if $svc.persistence }}
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: {{ $name }}-data
  labels: {{ $labels | toYaml | nindent 4 }}
spec:
  accessModes: [ReadWriteOnce]
  resources:
    requests:
      storage: {{ $svc.persistence.size | default "1Gi" }}
{{- end }}
---
apiVersion: v1
kind: Service
metadata:
  name: {{ $name }}
  labels: {{ $labels | toYaml | nindent 4 }}
spec:
  selector: {{ $selector | toYaml | nindent 4 }}
  ports:
    - name: http
      port: {{ $svc.port }}
      targetPort: http
{{- if and $svc.ingress $root.Values.global.ingress.enabled }}
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: {{ $name }}
  labels: {{ $labels | toYaml | nindent 4 }}
  {{- with $root.Values.global.ingress.annotations }}
  annotations: {{ toYaml . | nindent 4 }}
  {{- end }}
spec:
  ingressClassName: {{ $root.Values.global.ingress.className }}
  rules:
    - host: {{ printf "%s.%s" $name $root.Values.global.domain }}
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: {{ $name }}
                port:
                  name: http
{{- end }}
{{- end -}}
