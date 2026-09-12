terraform {
  required_version = ">= 1.0.0"

  required_providers {
    kubernetes = {
      source  = "hashicorp/kubernetes"
      version = "~> 2.23"
    }
  }
}

provider "kubernetes" {
  # Apunta al archivo de configuración local generado por Minikube
  config_path    = "~/.kube/config"
  config_context = "minikube"
}
