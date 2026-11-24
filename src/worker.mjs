// Serves the static site. Sends http and www visitors to https://brierlab.com
// so there is one address for every page.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.protocol === "http:" || url.hostname === "www.brierlab.com") {
      url.protocol = "https:";
      url.hostname = "brierlab.com";
      return Response.redirect(url.toString(), 301);
    }
    return env.ASSETS.fetch(request);
  },
};
