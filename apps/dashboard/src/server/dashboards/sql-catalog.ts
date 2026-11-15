// What the catalog and the agent guide say about dashboard SQL on ClickHouse.

export const TABLES: [
  name: string,
  database: "events" | "logs",
  scoped: boolean,
  description: string,
][] = [
  ["events", "events", true, "The project's events in the dashboard's range and source"],
  ["all_events", "events", false, "Every retained event of the project, for history and cohorts"],
  ["logs", "logs", true, "The project's logs in the dashboard's range and source"],
  ["all_logs", "logs", false, "Every retained log of the project"],
];

export const PARAMETERS = ["from", "to", "bucket", "source"] as const;

export const FUNCTIONS: [name: string, call: string, description: string][] = [
  [
    "bucket",
    "bucket(event_time)",
    "The start of the dashboard's bucket (hour, day, week from Monday, or month, in UTC) holding a DateTime or DateTime64",
  ],
];
