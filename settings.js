const serverConfig = {
    // Server configuration
    server: {
        port: 8081,
        address: '127.0.0.1'
    },

    // Proxy configuration
    proxy: {
        // Whitelist of domains allowed for proxying
        // Each entry can be a string (exact match) or a regular expression
        whitelist: [
            'usgs.entwine.io',
            'caltopo.com',
            'ngmdb.usgs.gov',
            'api.example.com',
            'data.example.org',
            'ot-process2.sdsc.edu',
            'noaa-nos-coastal-lidar-pds.s3.amazonaws.com',
        ]
    }
};

if (typeof module !== 'undefined' && module.exports) {
    // Node.js environment
    module.exports = serverConfig;
} else {
    // Browser environment
    window.serverConfig = serverConfig;
}
