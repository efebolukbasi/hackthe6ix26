// Archie's scripted "brain" for the no-API POC. Each topic is a sequence of
// steps: a spoken line plus whiteboard ops drawn while it's being said.
// Later, this whole file is replaced by an LLM emitting the same op schema.

const BLUE = "#4166d5", VIOLET = "#7b5bd6", RED = "#d94f46", GREEN = "#2e9e6b", AMBER = "#e8a13c", TEAL = "#279c94";

export const GREETING =
  "Hey, I'm Archie. Ask me an architecture question and I'll sketch the answer — try: how does OAuth work?";

export const DEFAULT_REPLY =
  "I've got a few whiteboard talks ready — try: how does OAuth work, Redis versus Kafka, or how do load balancers scale.";

export const CHIPS = [
  "How does OAuth work?",
  "Redis vs Kafka?",
  "What if Redis goes down?",
  "How do load balancers scale?",
];

export const TOPICS = [
  {
    id: "oauth",
    board: "oauth",
    fresh: true,
    match: ["oauth", "o auth", "log in with google", "login with google", "sign in with", "single sign", "sso", "authorization code"],
    steps: [
      {
        say: "Let's sketch it. Four parties: the user, your app, the auth server, and the API you actually want to call.",
        ops: [
          { op: "title", text: "OAuth 2.0 · authorization code flow" },
          { op: "node", id: "user", x: 210, y: 160, label: "User", sub: "browser", color: BLUE },
          { op: "node", id: "auth", x: 780, y: 160, label: "Auth Server", sub: "accounts.google.com", color: RED },
          { op: "node", id: "app", x: 210, y: 470, label: "Your App", sub: "client + backend", color: VIOLET },
          { op: "node", id: "api", x: 780, y: 470, label: "API", sub: "resource server", color: GREEN },
        ],
      },
      {
        say: "Your app never sees the password. It redirects the user to the auth server, where they log in and consent.",
        ops: [{ op: "arrow", id: "a1", from: "user", to: "auth", bow: -55, label: "1 · redirect & consent" }],
      },
      {
        say: "The auth server hands the browser a short-lived authorization code, which lands back at your app.",
        ops: [{ op: "arrow", id: "a2", from: "auth", to: "app", bow: 45, label: "2 · auth code" }],
      },
      {
        say: "Your app exchanges that code, plus its client secret, for an access token — a back-channel call attackers never see.",
        ops: [{ op: "arrow", id: "a3", from: "app", to: "auth", bow: 45, label: "3 · code + secret → token" }],
      },
      {
        say: "From then on, every API call just carries the token. If it leaks, it expires — unlike a password.",
        ops: [
          { op: "arrow", id: "a4", from: "app", to: "api", label: "4 · Bearer token" },
          { op: "note", x: 495, y: 640, text: "the password never touches your app", color: "#8a6d1f" },
        ],
      },
    ],
  },

  {
    id: "redis-kafka",
    board: "redis-kafka",
    fresh: true,
    match: ["redis", "kafka", "pub sub", "pub/sub", "pubsub", "message queue", "message broker", "event stream"],
    steps: [
      {
        say: "Both connect producers to consumers — the difference is what happens to a message after it's sent. Redis first.",
        ops: [
          { op: "title", text: "Redis pub/sub vs Kafka" },
          { op: "node", id: "prodL", x: 250, y: 170, label: "Producer", color: BLUE },
          { op: "node", id: "redis", x: 250, y: 380, label: "Redis", sub: "pub/sub · in-memory", color: RED },
          { op: "node", id: "subsL", x: 250, y: 590, label: "Subscribers", sub: "online right now", color: TEAL },
          { op: "arrow", id: "l1", from: "prodL", to: "redis", label: "PUBLISH" },
          { op: "arrow", id: "l2", from: "redis", to: "subsL", label: "fan-out" },
        ],
      },
      {
        say: "Redis is in-memory: sub-millisecond fan-out. But it's fire-and-forget — if a subscriber is down, that message is gone forever.",
        ops: [{ op: "note", x: 545, y: 300, text: "⚡ sub-ms latency\nmiss it → it's gone" }],
      },
      {
        say: "Kafka takes the opposite bet: every event is appended to a durable, replicated log on disk.",
        ops: [
          { op: "node", id: "prodR", x: 860, y: 170, label: "Producer", color: BLUE },
          { op: "node", id: "kafka", x: 860, y: 380, label: "Kafka", sub: "append-only log", color: VIOLET },
          { op: "node", id: "groups", x: 860, y: 590, label: "Consumer groups", sub: "read at own pace", color: GREEN },
          { op: "arrow", id: "r1", from: "prodR", to: "kafka", label: "append" },
          { op: "arrow", id: "r2", from: "kafka", to: "groups", label: "consume @ offset" },
        ],
      },
      {
        say: "Consumers track their own offset, so they can replay history — a brand-new service can re-read everything from day one.",
        ops: [
          { op: "circle", target: "kafka" },
          { op: "note", x: 545, y: 470, text: "🧾 durable log\nreplay from any offset" },
        ],
      },
      {
        say: "Rule of thumb: ephemeral signals go to Redis. Events your business can't afford to lose go to Kafka.",
        ops: [{ op: "note", x: 555, y: 668, text: "signals → Redis   ·   business events → Kafka", color: "#8a6d1f" }],
      },
    ],
  },

  {
    id: "redis-down",
    board: "redis-kafka",
    fresh: false,
    requires: "redis-kafka",
    match: ["goes down", "go down", "went down", "dies", "died", "die", "crash", "crashes", "crashed", "fails", "failure", "fault"],
    steps: [
      {
        say: "Let me show you on the board. If Redis dies, everything in flight vanishes — subscribers just go quiet.",
        ops: [
          { op: "cross", target: "redis" },
          { op: "fade", ids: ["l1", "l2"] },
        ],
      },
      {
        say: "Kafka's log lives on disk, across replicas. When consumers reconnect, they resume from their last offset — nothing is lost.",
        ops: [
          { op: "circle", target: "kafka", color: GREEN },
          { op: "note", x: 1075, y: 380, text: "✓ resumes\nat offset", color: GREEN },
        ],
      },
      {
        say: "So if durability under failure is the question — that's the case for Kafka.",
        ops: [],
      },
    ],
  },

  {
    id: "load-balancer",
    board: "load-balancer",
    fresh: true,
    match: ["load balancer", "load balancing", "load balance", "scale", "scaling", "horizontal", "lots of traffic", "handle traffic"],
    steps: [
      {
        say: "One box can only get so big — so we scale out, not up. All traffic lands on a load balancer first.",
        ops: [
          { op: "title", text: "Horizontal scaling 101" },
          { op: "node", id: "users", x: 600, y: 140, label: "Users", sub: "the internet", color: BLUE },
          { op: "node", id: "lb", x: 600, y: 340, label: "Load Balancer", sub: "nginx · ALB", color: AMBER },
          { op: "arrow", from: "users", to: "lb" },
        ],
      },
      {
        say: "Behind it sit identical, stateless servers. The balancer spreads requests across them — round-robin, or least-connections.",
        ops: [
          { op: "node", id: "s1", x: 260, y: 560, label: "Server A", color: GREEN },
          { op: "node", id: "s2", x: 600, y: 560, label: "Server B", color: GREEN },
          { op: "node", id: "s3", x: 940, y: 560, label: "Server C", color: GREEN },
          { op: "arrow", from: "lb", to: "s1" },
          { op: "arrow", from: "lb", to: "s2" },
          { op: "arrow", from: "lb", to: "s3" },
        ],
      },
      {
        say: "It also health-checks every server. A dead one is pulled from rotation automatically, and users never notice.",
        ops: [
          { op: "circle", target: "lb" },
          { op: "note", x: 600, y: 675, text: "health checks · a dead server is simply skipped" },
        ],
      },
      {
        say: "The catch is state: keep sessions in a shared store, not on the server — otherwise scaling breaks logins.",
        ops: [{ op: "note", x: 960, y: 300, text: "keep servers stateless\nsessions → shared store", color: "#8a6d1f" }],
      },
    ],
  },
];

export function interpret(raw, boardTopic) {
  const t = raw.toLowerCase();
  const has = (arr) => arr.some((k) => t.includes(k));

  if (has(["stop presenting", "back to the grid", "back to grid", "that's enough", "enough archie", "thanks archie", "thank you archie"]))
    return { type: "stop" };
  if (has(["clear the board", "clear board", "wipe the board", "start over"]))
    return { type: "clear" };

  // Failure follow-up outranks the base topic ("what if redis goes down"
  // contains "redis" too) — but only once the comparison is on the board.
  const fail = TOPICS.find((x) => x.id === "redis-down");
  if (boardTopic === "redis-kafka" && has(fail.match)) return { type: "topic", topic: fail };

  for (const topic of TOPICS) {
    if (topic.requires) continue;
    if (has(topic.match)) return { type: "topic", topic };
  }

  if (has(["archie", "hey agent", "what can you", "help me out"])) return { type: "default" };
  return null;
}
