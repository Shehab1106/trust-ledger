/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The reference library uses NodeNext-style ".js" import specifiers that point
  // at ".ts" sources; let the bundler resolve them.
  webpack: (config) => {
    config.resolve.extensionAlias = {
      ".js": [".ts", ".tsx", ".js"],
      ".jsx": [".tsx", ".jsx"],
    }
    return config
  },
}

export default nextConfig
