output "resource_group_name" {
  description = "Resource group for Iris-provisioned dynamic resources"
  value       = azurerm_resource_group.iris_dynamic.name
}

output "resource_group_location" {
  description = "Location of the dynamic resource group"
  value       = azurerm_resource_group.iris_dynamic.location
}
