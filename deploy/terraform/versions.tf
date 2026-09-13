terraform {
  required_version = ">= 1.9"

  required_providers {
    digitalocean = {
      source  = "digitalocean/digitalocean"
      version = "~> 2.43"
    }
  }

  # State lives in Spaces, which is S3-compatible but not S3. Every skip_* below
  # is required: the AWS provider's preflight checks (STS identity, region
  # validation, request checksums) all call AWS endpoints that Spaces does not
  # implement, and each one fails the backend before it ever reads state.
  backend "s3" {
    bucket = "crazzychat-tfstate"
    key    = "prod/terraform.tfstate"
    region = "us-east-1" # ignored by Spaces; required by the backend schema

    endpoints                   = { s3 = "https://blr1.digitaloceanspaces.com" }
    use_path_style              = true
    skip_credentials_validation = true
    skip_region_validation      = true
    skip_requesting_account_id  = true
    skip_metadata_api_check     = true
    skip_s3_checksum            = true
  }
}

provider "digitalocean" {
  token             = var.do_token
  spaces_access_id  = var.spaces_access_id
  spaces_secret_key = var.spaces_secret_key
}
