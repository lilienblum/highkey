CREATE TABLE event_catalog (
    product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    icon TEXT NOT NULL,
    color TEXT NOT NULL,
    description TEXT NOT NULL,
    sentence TEXT NOT NULL,
    conversion INTEGER NOT NULL DEFAULT 0 CHECK(conversion IN (0,1)),
    PRIMARY KEY(product_id,name)
);
