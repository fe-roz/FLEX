import requests
url = "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js"
data = requests.get(url, timeout=30).content
open(r"C:\Users\feroz\FLEX\viewer_build\libs\jszip.min.js", "wb").write(data)
print("Done,", len(data), "bytes")
