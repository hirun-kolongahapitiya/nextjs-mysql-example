/** @type {import('next').NextConfig} */
const nextConfig = {
    
    output: 'standalone',
    compress: true,
    poweredByHeader: false,
    webpack: (config, { isServer }) => {
        if (!isServer) {
            config.resolve.fallback.fs = false;
        }
        return config;
    },
};

export default nextConfig;
