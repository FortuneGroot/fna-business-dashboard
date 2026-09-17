"use client";

export default function ErrorState({ reset }: { error: Error; reset: () => void }) {
  return (
    <div className="app-content">
      <div className="banner error">
        Something went wrong in the branded shell. No account data was changed.
      </div>
      <button className="btn secondary" type="button" onClick={reset}>
        Try again
      </button>
    </div>
  );
}
