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
