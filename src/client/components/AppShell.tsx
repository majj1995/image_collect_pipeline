import { useEffect, useState, type PropsWithChildren } from "react";
import Database from "lucide-react/dist/esm/icons/database.mjs";
import { Link, NavLink } from "react-router-dom";
import { useApi } from "../api.js";
import { StatusBadge, type StatusKind } from "./StatusBadge.js";

export function AppShell({ children }: PropsWithChildren) {
  const api = useApi();
  const [connection, setConnection] = useState<StatusKind>("connecting");

  useEffect(() => {
    let active = true;
    void api.getHealth().then(
      (health) => { if (active) setConnection(health.ok ? "connected" : "disconnected"); },
      () => { if (active) setConnection("disconnected"); }
    );
    return () => { active = false; };
  }, [api]);

  return (
    <div className="app-shell">
      <header className="app-header">
        <Link className="app-mark" to="/" aria-label="素材扩展台首页">
          <span className="app-mark__icon" aria-hidden="true"><Database size={17} strokeWidth={2} /></span>
          <span>素材扩展台</span>
        </Link>
        <nav className="app-nav" aria-label="主导航">
          <NavLink to="/" end>采集任务</NavLink>
          <NavLink to="/settings">提供方</NavLink>
        </nav>
        <div className="app-connection" role="status" aria-live="polite">
          <StatusBadge status={connection} />
        </div>
      </header>
      <div className="app-surface">{children}</div>
    </div>
  );
}
