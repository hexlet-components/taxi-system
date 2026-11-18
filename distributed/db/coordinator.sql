CREATE TABLE placements (
    city integer PRIMARY KEY,
    node text NOT NULL CHECK (node IN ('node-a', 'node-b')),
    version integer NOT NULL CHECK (version > 0)
);
INSERT INTO placements VALUES (1, 'node-a', 1), (2, 'node-b', 1);
CREATE TABLE controller (
    id integer PRIMARY KEY CHECK (id = 1),
    generation integer NOT NULL DEFAULT 0,
    owner text NOT NULL DEFAULT '',
    expires_at timestamptz NOT NULL DEFAULT '-infinity'
);
INSERT INTO controller (id) VALUES (1);
CREATE TABLE transfers (
    id uuid PRIMARY KEY,
    city integer NOT NULL,
    source text NOT NULL,
    target text NOT NULL,
    old_version integer NOT NULL,
    stage text NOT NULL CHECK (stage IN ('intent', 'frozen', 'copied', 'published', 'done')),
    snapshot jsonb
);
CREATE UNIQUE INDEX one_transfer ON transfers (city) WHERE stage <> 'done';
