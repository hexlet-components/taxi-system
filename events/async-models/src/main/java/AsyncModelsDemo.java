public class AsyncModelsDemo {
    public static void main(String[] args) throws Exception {
        OfferProducer.main(args);
        OfferWorkers.main(args);
        SubscriptionsDemo.main(args);
        TripProducer.main(args);
        TripConsumer.main(args);
    }
}
