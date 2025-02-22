// content.js
(() => {
    get_all_file();
})();

function get_all_file() {
    let links = new Set();

    // Extract from <a> elements
    document.querySelectorAll("a[href$='.mp4']").forEach(a => {
        links.add({
            url: a.href,
            domain: new URL(a.href).hostname,
            filename: get_pretty_filename(a.href)
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
                filename: get_pretty_filename(video.src)
            });
        }
    });


    document.querySelectorAll("source").forEach(s => {
        if(s.src) {
            links.add({
                url: s.src,
                domain: new URL(s.src).hostname,
                filename: get_pretty_filename(s.src)
            });
        }
    });

    // Log all found mp4 links to console
    console.log("Found MP4 files:", Array.from(links));
    browser.runtime.sendMessage({ action: "mp4_links", links: Array.from(links) });
}

function get_pretty_filename(s) {
    let name = s.split('?')[0].split('/')

    while(name[name.length - 1] === '') {
        name.pop()
    }

    return name[name.length - 1]
}