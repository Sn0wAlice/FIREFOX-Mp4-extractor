document.addEventListener("DOMContentLoaded", () => {
    chrome.runtime.onMessage.addListener((message) => {
        if (message.action === "mp4_links") {
            let table = document.getElementById("mp4Table");
            message.links.forEach(link => {
                let row = table.insertRow();
                row.insertCell(0).textContent = link.domain;
                row.insertCell(1).textContent = link.filename;

                let btn = document.createElement("button");
                btn.textContent = "Download";
                btn.onclick = () => chrome.runtime.sendMessage({ action: "download", url: link.url, filename: link.filename });
                row.insertCell(2).appendChild(btn);
            });
        }
    });

    chrome.tabs.executeScript({ file: "content.js" });
});
