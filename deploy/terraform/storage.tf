# ── Container registry ──────────────────────────────────────────────────
resource "digitalocean_container_registry" "main" {
  name                   = var.project_name
  subscription_tier_slug = "professional"
  region                 = var.region
}

# ── Broadcast HLS bucket ────────────────────────────────────────────────
#
# ONLY broadcast segments. Chat media stays on Cloudflare R2, which is where
# production already keeps it and where egress is free — and for a messenger
# shipping media to phones, egress is the bill. Moving it would re-sign every
# URL for no benefit.
#
# HLS is different: the segments are public, cacheable, and benefit from a CDN
# sitting in the same region as the cluster that writes them. That is the one
# case where Spaces earns its place.
#
# NOTE: unlike R2, Spaces validates the SigV4 credential scope against the
# datacenter region, so S3_REGION for THIS bucket must be the region slug.
# "auto" — correct for R2 and the current default — produces SignatureDoesNotMatch
# on every operation against Spaces.
resource "digitalocean_spaces_bucket" "broadcast" {
  name   = "${var.project_name}-broadcast"
  region = var.region
  acl    = "private"

  lifecycle_rule {
    id      = "expire-old-segments"
    enabled = true
    # Segments are replayable VOD for a short window, not an archive. A
    # broadcast nobody watched should not bill storage forever.
    expiration {
      days = 30
    }
  }
}

resource "digitalocean_cdn" "broadcast" {
  origin = digitalocean_spaces_bucket.broadcast.bucket_domain_name
  ttl    = 3600
}
