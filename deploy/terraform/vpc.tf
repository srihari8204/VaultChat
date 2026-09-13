resource "digitalocean_vpc" "main" {
  name     = "${var.project_name}-vpc"
  region   = var.region
  ip_range = "10.110.0.0/16"
}

resource "digitalocean_project" "main" {
  name        = var.project_name
  description = "CrazzyChat production — DOKS, managed data, media edge."
  purpose     = "Web Application"
  environment = "Production"
}
