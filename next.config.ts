import type { NextConfig } from "next";

const nextConfig: NextConfig = {
	reactStrictMode: false,
	allowedDevOrigins: ['192.168.50.216', '*.local', 'localhost'],
};

export default nextConfig;
