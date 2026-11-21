-- No row means all projects, including future ones. A row with no grants means none.
CREATE TABLE restricted_members (
  member_id TEXT PRIMARY KEY REFERENCES member(id) ON DELETE CASCADE
);
CREATE TABLE member_projects (
  member_id TEXT NOT NULL REFERENCES restricted_members(member_id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  access TEXT NOT NULL CHECK(access IN ('read','write')),
  PRIMARY KEY(member_id,project_id)
);
