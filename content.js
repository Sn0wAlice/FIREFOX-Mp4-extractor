// content.js
(() => {
    let links = new Set();

    // Extract from <a> elements
    document.querySelectorAll("a[href$='.mp4']").forEach(a => {
        links.add({
            url: a.href,
            domain: new URL(a.href).hostname,
            filename: a.href.split('/').pop().split('?')[0]
        });
    });

    // Extract from <video> elements

    // select all video tags: 
    document.querySelectorAll("video").forEach(video => {
        // check if video tag has a src attribute
        if (video.src) {
            // add the video src to the links set
            links.add({
                url: video.src,
                domain: new URL(video.src).hostname,
                filename: video.src.split('/').pop().split('?')[0]
            });
        }
    });

    // Extract from <source> elements
    document.querySelectorAll("source[src$='.mp4']").forEach(source => {
        links.add({
            url: source.src,
            domain: new URL(source.src).hostname,
            filename: source.src.split('/').pop().split('?')[0]
        });
    });

    // Log all found mp4 links to console
    console.log("Found MP4 files:", Array.from(links));
    browser.runtime.sendMessage({ action: "mp4_links", links: Array.from(links) });
})();