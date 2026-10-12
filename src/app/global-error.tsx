"use client";

export default function GlobalError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: "sans-serif", padding: 32 }}>
        <h1>Something went wrong</h1>
        <p>The page could not be loaded. Try again.</p>
        <button type="button" onClick={() => reset()}>
          Try again
        </button>
      </body>
    </html>
  );
}
