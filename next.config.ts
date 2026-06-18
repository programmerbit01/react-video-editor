import type { NextConfig } from "next";

const nextConfig: NextConfig = {
	reactStrictMode: false,
	basePath: '/editor',
	allowedDevOrigins: ['192.168.50.216', '*.local', 'localhost', 'vh.tomtap.ai', '*.tomtap.ai'],
	env: {
		NEXT_PUBLIC_BASE_PATH: '/editor',
	},
	serverExternalPackages: [
		'@napi-rs/canvas',
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
