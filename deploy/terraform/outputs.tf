output "cluster_id" { value = digitalocean_kubernetes_cluster.main.id }
output "cluster_endpoint" { value = digitalocean_kubernetes_cluster.main.endpoint }
output "registry_endpoint" { value = digitalocean_container_registry.main.endpoint }

# Private hostnames keep database traffic inside the VPC. Using the public host
# from inside the cluster works and is the easy mistake — it egresses and comes
# back, and it bills.
output "pg_private_host" {
  value     = digitalocean_database_cluster.pg.private_host
  sensitive = true
}
output "pg_pool_port" { value = digitalocean_database_connection_pool.txn.port }
output "pg_pool_name" { value = digitalocean_database_connection_pool.txn.name }

output "valkey_app_uri" {
  value     = digitalocean_database_cluster.valkey_app.private_uri
  sensitive = true
}
output "valkey_calls_uri" {
  value     = digitalocean_database_cluster.valkey_calls.private_uri
  sensitive = true
}
output "valkey_golive_uri" {
  value     = digitalocean_database_cluster.valkey_golive.private_uri
  sensitive = true
}

output "broadcast_cdn_endpoint" { value = digitalocean_cdn.broadcast.endpoint }
