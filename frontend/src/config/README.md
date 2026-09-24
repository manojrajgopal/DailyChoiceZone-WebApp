# `src/config`

Frontend configuration. Not business data.

Everything a customer or an administrator can change — products, orders,
customers, invoices, coupons, banners, homepage sections, store settings, tax
rates — lives in MySQL and reaches the browser through the API. None of it is
in this repository, and none of it is read from a file at runtime.

What is here is the shape of the *application*: which links the header shows and
which groups the portal's sidebar has. It is checked in for two reasons:

- Every entry names a route that has to exist in `src/app`. A menu item stored
  in a database can point at a page that was never built; one stored beside the
  pages cannot, because the build would have to be changed to break it.
- The header renders on the server, on the first paint, before any request has
  been made. Fetching it would mean either a blocking call on every page or a
  navigation bar that appears a moment late.

If menus ever become something a non-developer edits, they become business data
and move to the database like everything else — a `listNavigation()` on the
data source, and this folder shrinks.
