(function(root) {
    function isWhitelisted(hostname) {
        return serverConfig.proxy.whitelist.some(entry => {
            if (entry instanceof RegExp) {
                return entry.test(hostname);
            }
            return entry === hostname;
        });
    }

    function generateProxyUrl(targetUrl) {
        try {
            const parsedUrl = new URL(targetUrl);

            if (!isWhitelisted(parsedUrl.hostname)) {
                console.warn('Domain not whitelisted in CORS proxy:', targetUrl);
		return targetUrl
            }

            // Note: We're using the current origin instead of hardcoded server address and port
            const proxyBaseUrl = `${window.location.origin}/proxy`;
            return `${proxyBaseUrl}?url=${encodeURIComponent(targetUrl)}`;
        } catch (error) {
            console.error('Error generating proxy URL:', error);
            return null;
        }
    }

    root.ProxyUrlGenerator = {
        generateProxyUrl: generateProxyUrl
    };
}(typeof self !== 'undefined' ? self : this));
