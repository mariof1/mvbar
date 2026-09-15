/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  env: { NEXT_PUBLIC_MVBAR_WEB_VERSION: require('./package.json').version }
};
module.exports = nextConfig;
