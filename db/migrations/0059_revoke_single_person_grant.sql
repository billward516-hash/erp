-- Single-person approval is a licence term set by the operator at provisioning, never by the app (D-161). The app role
-- was granted UPDATE on it in 0040 but nothing uses the grant, so a compromised app connection could switch it on.
REVOKE UPDATE (single_person_approval) ON tenant_license FROM erp_app;
