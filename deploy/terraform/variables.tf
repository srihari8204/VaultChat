variable "do_token" {
  description = "DigitalOcean API token with read/write scope."
  type        = string
  sensitive   = true
}

variable "spaces_access_id" {
  type      = string
  sensitive = true
}

variable "spaces_secret_key" {
  type      = string
  sensitive = true
}

# blr1, not fra1. The current deployment serves India from Germany and the repo
# measures the result: a cold request is ~640ms, of which ~600ms is three round
# trips to Frankfurt. Moving the origin is a larger user-visible win than
# anything else in this migration. Every managed service below must sit in the
# same region as the cluster or the VPC-private networking does not apply.
variable "region" {
  type    = string
  default = "blr1"
}

variable "cluster_version" {
  description = "DOKS version slug. Pin it: an unpinned cluster is upgraded under you."
  type        = string
  default     = "1.33.1-do.0"
}

variable "project_name" {
  type    = string
  default = "crazzychat"
}

# Maintenance runs at 03:30 IST = 22:00 UTC. This matters more than usual here:
# a media node recycle changes the node's public IP, and that IP is inside every
# live ICE candidate, so calls on that node drop. Pick the quietest hour.
variable "maintenance_start_utc" {
  type    = string
  default = "22:00"
}

variable "domain_primary" {
  description = "New brand domain. The legacy domain is NOT managed here — it stays on Cloudflare."
  type        = string
  default     = "crazzychat.com"
}
