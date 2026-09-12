# 1. Creación del Namespace para el entorno
resource "kubernetes_namespace" "integracentro_prod" {
  metadata {
    name = "integracentro-prod"
    
    labels = {
      environment = "local-minikube"
      project     = "integracentro"
    }
  }
}

# 2. Reclamación de Volumen Persistente (PVC) para la Bóveda de Evidencias
resource "kubernetes_persistent_volume_claim" "vault_pvc" {
  metadata {
    name      = "ic-vault-pvc"
    # Corrección: Se agrega [0] para acceder correctamente al atributo
    namespace = kubernetes_namespace.integracentro_prod.metadata[0].name
    
    labels = {
      app = "vault-manager"
    }
  }

  spec {
    access_modes = ["ReadWriteOnce"]
    
    resources {
      requests = {
        storage = "5Gi" # Límite de 5 GB para no saturar tu Mac
      }
    }
    
    # "standard" es el provisionador por defecto de Minikube (hostpath)
    storage_class_name = "standard" 
  }
}