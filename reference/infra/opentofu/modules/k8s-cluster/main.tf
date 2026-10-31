# Interface only. An implementation creates a cluster with the provider of your choice and fills the outputs;
# the rest of the platform only needs a kubeconfig, then installs the chart through Argo CD
# (reference/infra/argocd/application.yaml). Managed Kubernetes, k3s on VMs and kubeadm all fit.
