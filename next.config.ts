import type { NextConfig } from "next";

const nextConfig: NextConfig = {
	reactStrictMode: false,
	basePath: '/editor',
	allowedDevOrigins: ['192.168.50.216', '*.local', 'localhost', 'vh.tomtap.ai', '*.tomtap.ai'],
	env: {
		NEXT_PUBLIC_BASE_PATH: '/editor',
	},
	serverExternalPackages: ['@napi-rs/canvas'],
};

export default nextConfig;
