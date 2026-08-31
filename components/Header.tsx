import Link from "next/link";

export default function Header() {
  return (
    <header className="site-header">
      <div className="shell header-inner">
        <Link href="/" className="brand" aria-label="TenderFans home">
          <span className="brand-mark">T</span>
          <span>TenderFans</span>
        </Link>
        <nav className="nav">
          <Link href="/shout">Give a Shout</Link>
          <Link href="/claim">Claim Profile</Link>
          <button className="nav-login" type="button">Sign in</button>
        </nav>
      </div>
    </header>
  );
}
