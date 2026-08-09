# Tech Debt Tracker

Track durable gaps that should not be lost between agent sessions.

| Gap | Impact | Owner | Target | Status |
| --- | --- | --- | --- | --- |
| Record immutable AgentV release and reboot-canary evidence | Release CI requires live Ubuntu and disposable Rocky Linux 9 systemd gates, but production promotion still needs green published-asset evidence plus a staging power-cycle during incomplete transaction recovery | AgentV maintainers | Before AgentV production rollout | Open |
| Add metrics or health signal | Improves operations beyond structured logs | AgentV maintainers | Future runtime hardening | Open |
