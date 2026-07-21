export default function Ended() {
  return (
    <div id="ended">
      <div className="ended-card">
        <p>You left <em>the room</em>.</p>
        <p className="ended-sub">Forge waved goodbye 👋</p>
        <button onClick={() => location.reload()}>Rejoin</button>
      </div>
    </div>
  );
}
