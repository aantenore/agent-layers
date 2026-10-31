terraform {
  required_version = ">= 1.8"

  # Provider placeholders: uncomment the one that matches your target and implement main.tf with it.
  # required_providers {
  #   hcloud     = { source = "hetznercloud/hcloud" }   # e.g. a k3s/kubeadm cluster on VMs
  #   kubernetes = { source = "hashicorp/kubernetes" }  # bootstrapping an existing cluster
  #   helm       = { source = "hashicorp/helm" }        # installing the chart or Argo CD
  # }
}
