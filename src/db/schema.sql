PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS cv_workspaces (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS cv_knowledge_files (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES cv_workspaces(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  content TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('upload', 'github', 'linkedin', 'xing', 'x', 'company', 'clarification')),
  source_url TEXT,
  content_bytes INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS cv_company_sources (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES cv_workspaces(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  title TEXT,
  content TEXT NOT NULL,
  summary TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_knowledge_workspace ON cv_knowledge_files(workspace_id, created_at);
CREATE INDEX IF NOT EXISTS idx_knowledge_expires ON cv_knowledge_files(expires_at);
CREATE INDEX IF NOT EXISTS idx_company_workspace ON cv_company_sources(workspace_id, created_at);
