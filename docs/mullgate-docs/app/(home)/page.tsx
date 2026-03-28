import Link from 'next/link';

export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-4xl flex-1 flex-col items-center justify-center px-6 py-16 text-center">
      <p className="mb-3 text-sm font-medium uppercase tracking-[0.2em] text-fd-muted-foreground">
        Mullgate Documentation
      </p>
      <h1 className="mb-4 text-4xl font-bold sm:text-5xl">
        50 concurrent proxies, one shared Mullvad device
      </h1>
      <p className="mb-8 max-w-2xl text-fd-muted-foreground sm:text-lg">
        Learn the smaller `setup` / `proxy` / `config` command model, see the 50-route proof, and
        operate Mullgate without turning the whole machine into a VPN tunnel.
      </p>
      <div className="flex flex-wrap items-center justify-center gap-4">
        <Link
          href="/docs"
          className="rounded-md bg-fd-primary px-5 py-3 text-fd-primary-foreground"
        >
          Open docs
        </Link>
        <Link href="/docs/getting-started/quickstart" className="rounded-md border px-5 py-3">
          Quickstart
        </Link>
      </div>
    </main>
  );
}
