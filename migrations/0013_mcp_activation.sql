CREATE TABLE project_mcp_connections (
  product_id TEXT PRIMARY KEY REFERENCES products(id) ON DELETE CASCADE
);
