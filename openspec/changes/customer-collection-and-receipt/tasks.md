## 1. Customer-confirmed collection (backend)

- [x] 1.1 Migration `070_shopbook_collected_by.sql`: additive `collected_by` column on `shopbook_order` (`''|customer|owner`), idempotent
- [x] 1.2 Go: `POST /shopbook/orders/{id}/collected` — customer-scoped, `ready` only, reuses `sbSettleOrder`, records `collected_by='customer'`, timeline events, notifies the owner; already-collected orders return success without re-settling
- [x] 1.3 Go: owner collection path stamps `collected_by='owner'`; order detail exposes `collectedBy`

## 2. Customer-confirmed collection (client)

- [x] 2.1 `services/shopBookService.ts`: `confirmCollected(orderId)` + `collectedBy` on `OrderDetail`
- [x] 2.2 `utils/shopbook.ts`: `canCustomerConfirmCollection(status)` helper
- [x] 2.3 `app/shop-book.tsx`: "I've collected my order" action on the customer tracking screen at Ready, with confirmation; timeline shows who confirmed

## 3. B2C retail receipt

- [x] 3.1 `app/shop-book.tsx`: restyle the in-app receipt — shop header, order ID/date, customer + address, retail line prices, savings, amount paid, single "Inclusive of all taxes" line, no business tax identifiers
- [x] 3.2 Restyle the shareable PDF to match, using the shop's country currency and date format
- [x] 3.3 Add the receipt strings to all six i18n catalogs

## 4. Polish & verification

- [x] 4.1 Thread shop currency through the owner khata screens (replacing the remaining hardcoded ₹)
- [x] 4.2 Extend `utils/shopbook.selftest.ts` for the collection-window helper
- [x] 4.3 `go build`/`go vet`, `tsc --noEmit`, and `npm test` clean
