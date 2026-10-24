import com.rabbitmq.client.BuiltinExchangeType;
import com.rabbitmq.client.ConnectionFactory;

import java.nio.charset.StandardCharsets;
import java.util.List;

public class SubscriptionsDemo {
    public static void main(String[] args) throws Exception {
        var factory = new ConnectionFactory();
        factory.setHost(System.getenv().getOrDefault("RABBITMQ_HOST", "localhost"));
        factory.setUsername("lesson");
        factory.setPassword("lesson");

        try (var connection = factory.newConnection();
                var channel = connection.createChannel()) {
            channel.exchangeDeclare("lesson-trip-events", BuiltinExchangeType.FANOUT, true);

            // Оформляем обе подписки до публикации события
            for (String queue : List.of("lesson-receipts", "lesson-report")) {
                channel.queueDeclare(queue, true, false, false, null);
                channel.queueBind(queue, "lesson-trip-events", "");
            }

            String event = "{\"event_type\":\"TripCompleted\",\"trip_id\":42}";
            channel.confirmSelect();
            channel.basicPublish(
                    "lesson-trip-events", "", null, event.getBytes(StandardCharsets.UTF_8));
            channel.waitForConfirmsOrDie(5000);

            // Каждая роль читает свою очередь и получает собственную копию
            for (String queue : List.of("lesson-receipts", "lesson-report")) {
                var delivery = channel.basicGet(queue, false);
                if (delivery == null) {
                    throw new IllegalStateException("Missing event in " + queue);
                }
                String received = new String(delivery.getBody(), StandardCharsets.UTF_8);
                System.out.println(queue + ": " + received);
                channel.basicAck(delivery.getEnvelope().getDeliveryTag(), false);
            }
        }
    }
}
