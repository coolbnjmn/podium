import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { FleetApp } from "./fleet/FleetApp";
import { AdminView } from "./fleet/admin/AdminView";
import { HistoryView } from "./fleet/HistoryView";
import { routeFor } from "./route";

function Root() {
  const [hash, setHash] = useState(() => window.location.hash);
  useEffect(() => {
    const onHash = () => setHash(window.location.hash);
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  const route = routeFor(hash);
  if (route === "history") return <HistoryView />;
  if (route === "admin") return <AdminView />;
  // The board is a page of the fleet console, so it is the same element with a flag: opening a card keeps the selection it made.
  return <FleetApp board={route === "board"} />;
}

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Root element not found");
}

createRoot(rootElement).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
