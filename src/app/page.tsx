export default function HomePage() {
  return (
    <main style={{ fontFamily: "sans-serif", padding: 32, maxWidth: 640 }}>
      <h1>Agent Chat API</h1>
      <p>This service is the backend. The chat UI runs in the frontend app.</p>
      <p>
        Health: <a href="/api/health">/api/health</a>
      </p>
    </main>
  );
}
