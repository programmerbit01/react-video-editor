import type { NextConfig } from "next";

const nextConfig: NextConfig = {
	reactStrictMode: false,
	basePath: '/editor',
	allowedDevOrigins: ['192.168.50.216', '*.local', 'localhost', 'vh.tomtap.ai', '*.tomtap.ai'],
	// Allow these hosts when running behind a reverse proxy (external access via vh2.tomtap.ai)
	experimental: {
		serverActions: {
			allowedOrigins: [
				'vh.tomtap.ai',
				'vh2.tomtap.ai',
				'vapp.tomtap.ai',
				'vapp2.tomtap.ai',
				'localhost:3000',
				'localhost:3001',
				'192.168.50.161:3000',
				'192.168.50.216:3000',
				'192.168.50.86:3000',
			],
		},
	},
	env: {
		NEXT_PUBLIC_BASE_PATH: '/editor',
		// Stamped at BUILD time, so it changes on every deploy and only then. An inline
		// head script compares it against localStorage and drops stale derived caches
		// once when it changes — see src/features/editor/utils/build-stamp.ts for why a
		// reload cannot clear those and why users ended up switching browsers instead.
		NEXT_PUBLIC_BUILD_STAMP: String(Date.now()),
	},
	// Cross-origin remote rendering: another editor instance POSTs a project here and
	// polls status / downloads the result from a different origin. Allow those requests.
	async headers() {
		const cors = [
			{ key: 'Access-Control-Allow-Origin', value: '*' },
			{ key: 'Access-Control-Allow-Methods', value: 'GET, POST, OPTIONS' },
			{ key: 'Access-Control-Allow-Headers', value: 'Content-Type' },
			{ key: 'Access-Control-Max-Age', value: '86400' },
		];
		return [
			{ source: '/api/render-remotion/:path*', headers: cors },
			{ source: '/api/render-remotion', headers: cors },
			{ source: '/api/render/:path*', headers: cors },
			{ source: '/api/render', headers: cors },
		];
	},
	serverExternalPackages: [
		'@napi-rs/canvas',
		'remotion',
		'@remotion/bundler',
		'@remotion/renderer',
		// platform-specific native compositor binaries — webpack must not bundle these
		'@remotion/compositor-darwin-arm64',
		'@remotion/compositor-darwin-x64',
		'@remotion/compositor-linux-x64-gnu',
		'@remotion/compositor-linux-x64-musl',
		'@remotion/compositor-linux-arm64-gnu',
		'@remotion/compositor-linux-arm64-musl',
		'@remotion/compositor-win32-x64-msvc',
		'esbuild',
		'@chatoctopus/timeline',
	],
};

export default nextConfig;
